<?php
$method = $_SERVER["REQUEST_METHOD"];
$origins = array_values(array_filter(
    array_map("trim", explode(",", (string) getenv("TRANSCRIPT_ALLOWED_ORIGINS"))),
    fn($origin) => $origin !== ""
));
$token = (string) getenv("TRANSCRIPT_API_TOKEN");
header("Cache-Control: no-store");
foreach ($origins as $allowedOrigin) {
    if (!preg_match('~^https?://(?:\[[0-9a-fA-F:]+\]|[a-zA-Z0-9.-]+)(?::[0-9]+)?$~D', $allowedOrigin)) {
        http_response_code(503);
        exit("Invalid CORS configuration");
    }
}
if ($origins !== [] && $token === "") {
    http_response_code(503);
    exit("Invalid CORS configuration");
}
$origin = $_SERVER["HTTP_ORIGIN"] ?? null;
$scheme = !empty($_SERVER["HTTPS"]) && $_SERVER["HTTPS"] !== "off" ? "https" : "http";
$sameOrigin = $scheme . "://" . ($_SERVER["HTTP_HOST"] ?? "");
$allowed = $origin !== null && in_array($origin, $origins, true);
if ($origin !== null && $origin !== $sameOrigin && !$allowed) {
    http_response_code($method === "OPTIONS" ? 400 : 403);
    exit("Origin is not allowed");
}
if ($allowed) {
    header("Access-Control-Allow-Origin: " . $origin);
    header("Vary: Origin");
}
if ($method === "OPTIONS") {
    if ($origin !== null && isset($_SERVER["HTTP_ACCESS_CONTROL_REQUEST_METHOD"])) {
        header("Vary: Origin, Access-Control-Request-Method, Access-Control-Request-Headers, Access-Control-Request-Private-Network");
        $requestedHeaders = array_filter(array_map(
            "trim",
            explode(",", strtolower($_SERVER["HTTP_ACCESS_CONTROL_REQUEST_HEADERS"] ?? ""))
        ));
        if (!in_array($_SERVER["HTTP_ACCESS_CONTROL_REQUEST_METHOD"], ["HEAD", "POST", "OPTIONS"], true)
            || array_diff($requestedHeaders, ["accept", "accept-language", "content-language", "content-type", "authorization"]) !== []
            || isset($_SERVER["HTTP_ACCESS_CONTROL_REQUEST_PRIVATE_NETWORK"])) {
            http_response_code(400);
            exit("Preflight is not allowed");
        }
        header("Access-Control-Allow-Methods: HEAD, POST, OPTIONS");
        header("Access-Control-Allow-Headers: Content-Type, Authorization");
        header("Access-Control-Max-Age: 600");
        exit;
    }
    http_response_code(204);
    exit;
}
if (!in_array($method, ["HEAD", "POST"], true)) {
    header("Allow: HEAD, POST, OPTIONS");
    http_response_code(405);
    exit;
}
[$authScheme, $suppliedToken] = array_pad(explode(" ", $_SERVER["HTTP_AUTHORIZATION"] ?? "", 2), 2, "");
if ($token !== "" && (strtolower($authScheme) !== "bearer" || !hash_equals($token, $suppliedToken))) {
    header("WWW-Authenticate: Bearer");
    http_response_code(401);
    exit("Authentication required");
}

$directory = rtrim((string) getenv("TRANSCRIPT_DATA_DIR"), "/");
if ($directory === "") {
    http_response_code(500);
    if ($_SERVER["REQUEST_METHOD"] !== "HEAD") {
        echo json_encode(["status" => false, "message" => "TRANSCRIPT_DATA_DIR is not set"]);
    }
    exit;
}

if ($_SERVER["REQUEST_METHOD"] === "HEAD") {
    exit;
}

function atomicWrite($path, $content) {
    $temporary = @tempnam(dirname($path), ".snapshot-");
    if ($temporary === false) {
        throw new RuntimeException("Cannot create snapshot file");
    }
    try {
        if (realpath(dirname($temporary)) !== realpath(dirname($path))) {
            throw new RuntimeException("Cannot create snapshot file in data directory");
        }
        if (@file_put_contents($temporary, $content) !== strlen($content)) {
            throw new RuntimeException("Cannot write snapshot file");
        }
        if (!@rename($temporary, $path)) {
            throw new RuntimeException("Cannot replace snapshot file");
        }
    } finally {
        if (file_exists($temporary)) {
            unlink($temporary);
        }
    }
}

const MAX_TIMESTAMP = 4102444799;
const MAX_TRANSCRIPT_BYTES = 65536;
const MAX_FULL_ENTRIES = 10000;
const MAX_FULL_BYTES = 1048576;

function validTranscript($value) {
    return is_string($value) && strlen($value) <= MAX_TRANSCRIPT_BYTES;
}

$json = json_decode(@file_get_contents("php://input"));
if (json_last_error() !== JSON_ERROR_NONE || !is_object($json)
    || !isset($json->startTime, $json->revision, $json->full, $json->transcript)
    || !validTranscript($json->transcript)
    || !(is_int($json->startTime) || is_float($json->startTime))
    || !is_finite((float) $json->startTime)
    || $json->startTime < 0 || $json->startTime >= MAX_TIMESTAMP + 1
    || !is_array($json->full) || count($json->full) > MAX_FULL_ENTRIES
    || !is_int($json->revision) || $json->revision <= 0
    || $json->revision > 9007199254740991) {
    http_response_code(400);
    exit(json_encode(["status" => false, "message" => "Invalid snapshot"]));
}

$fullBytes = 0;
$full = [];
foreach ($json->full as $item) {
    if (!is_object($item) || !isset($item->timeStamp, $item->transcript)
        || !is_int($item->timeStamp) || $item->timeStamp < 0
        || $item->timeStamp > MAX_TIMESTAMP || !validTranscript($item->transcript)) {
        http_response_code(400);
        exit(json_encode(["status" => false, "message" => "Invalid transcript entry"]));
    }
    $fullBytes += strlen($item->transcript);
    if ($fullBytes > MAX_FULL_BYTES) {
        http_response_code(400);
        exit(json_encode(["status" => false, "message" => "Snapshot exceeds the UTF-8 byte limit"]));
    }
    $full[] = ["timeStamp" => $item->timeStamp, "transcript" => $item->transcript];
}

$lock = false;
try {
    if (!is_dir($directory) && !@mkdir($directory) && !is_dir($directory)) {
        throw new RuntimeException("Cannot create data directory");
    }
    $base = $directory . "/" . date("Y-m-d H-i-s", (int) $json->startTime);
    $lock = @fopen($base . ".lock", "c+b");
    if ($lock === false || !flock($lock, LOCK_EX)) {
        throw new RuntimeException("Cannot lock session");
    }
    $snapshotPath = $base . ".snapshot.json";
    $snapshot = ["revision" => $json->revision, "full" => $full];
    if (file_exists($snapshotPath)) {
        $saved = @file_get_contents($snapshotPath);
        if ($saved === false) {
            throw new RuntimeException("Cannot read snapshot");
        }
        $previous = json_decode($saved, true);
        if (json_last_error() !== JSON_ERROR_NONE || !isset($previous["revision"], $previous["full"])) {
            throw new RuntimeException("Invalid saved snapshot");
        }
        if ($previous["revision"] >= $snapshot["revision"]) {
            $snapshot = $previous;
        }
    }
    $full = [];
    foreach ($snapshot["full"] as $item) {
        $full[] = $item["timeStamp"] . "s\t" . $item["transcript"];
    }
    $encodedSnapshot = json_encode($snapshot);
    $encodedFull = json_encode($snapshot["full"]);
    if ($encodedSnapshot === false || $encodedFull === false) {
        throw new RuntimeException("Cannot encode snapshot");
    }
    // Persist the revision with its data first so retries can repair incomplete exports.
    atomicWrite($snapshotPath, $encodedSnapshot);
    atomicWrite($base . ".log", implode("\n", $full));
    atomicWrite($base . ".json", $encodedFull);
} catch (Throwable $error) {
    http_response_code(500);
    echo json_encode(["status" => false, "message" => "Cannot save snapshot"]);
} finally {
    if ($lock !== false) {
        fclose($lock);
    }
}
