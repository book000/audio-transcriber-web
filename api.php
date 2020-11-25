<?php
$json = file_get_contents("php://input");
$json = json_decode($json, true);
if (json_last_error() != JSON_ERROR_NONE) {
    http_response_code(400);
    exit(json_encode(
        [
            "status" => false,
            "message" => "Invalid json",
            "error" => json_last_error_msg()
        ]
    ));
}

if (!file_exists(__DIR__ . "/data/")) {
    mkdir(__DIR__ . "/data/");
}

$startTime = $json["startTime"];
$timeStamp = $json["timeStamp"];
$date = date("Y-m-d H-i-s", $startTime);
$transcript = $json["transcript"];
$fullData = $json["full"];

$full = [];
foreach ($fullData as $data) {
    $full[] = $data["timeStamp"] . "s\t" . $data["transcript"];
}

file_put_contents(__DIR__ . "/data/" . $date . ".log", implode("\n", $full));
file_put_contents(__DIR__ . "/data/" . $date . ".json", json_encode($fullData));