<?php
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

$json = json_decode(@file_get_contents("php://input"), true);
if (json_last_error() !== JSON_ERROR_NONE || !is_array($json)
    || !isset($json["startTime"], $json["revision"], $json["full"])
    || !isset($json["transcript"]) || !is_string($json["transcript"])
    || !is_numeric($json["startTime"]) || !is_array($json["full"])
    || !is_int($json["revision"]) || $json["revision"] <= 0
    || $json["revision"] > 9007199254740991) {
    http_response_code(400);
    exit(json_encode(["status" => false, "message" => "Invalid snapshot"]));
}

foreach ($json["full"] as $item) {
    if (!is_array($item) || !isset($item["timeStamp"], $item["transcript"])
        || !is_int($item["timeStamp"]) || !is_string($item["transcript"])) {
        http_response_code(400);
        exit(json_encode(["status" => false, "message" => "Invalid transcript entry"]));
    }
}

$lock = false;
try {
    if (!is_dir($directory) && !@mkdir($directory) && !is_dir($directory)) {
        throw new RuntimeException("Cannot create data directory");
    }
    $base = $directory . "/" . date("Y-m-d H-i-s", (int) $json["startTime"]);
    $lock = @fopen($base . ".lock", "c+b");
    if ($lock === false || !flock($lock, LOCK_EX)) {
        throw new RuntimeException("Cannot lock session");
    }
    $snapshotPath = $base . ".snapshot.json";
    $snapshot = ["revision" => $json["revision"], "full" => $json["full"]];
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
