<?php

function isPersistentCounterName(string $name): bool
{
    return preg_match('/^[a-z-]+$/', $name) === 1;
}

function persistentCounterValue(string $name, bool $increment = false): int
{
    $counter = fopen('/data/' . $name, 'c+');
    if (!$counter || !flock($counter, LOCK_EX)) {
        http_response_code(500);
        exit;
    }

    rewind($counter);
    $value = (int) stream_get_contents($counter);
    if ($increment) {
        $value++;
        ftruncate($counter, 0);
        rewind($counter);
        fwrite($counter, (string) $value);
        fflush($counter);
    }

    flock($counter, LOCK_UN);
    fclose($counter);
    return $value;
}

function incrementPersistentCounter(string $name): int
{
    return persistentCounterValue($name, true);
}

// This file is also loaded by execute jobs, which call
// incrementPersistentCounter directly instead of handling an HTTP request.
if (!isset($_SERVER['REQUEST_URI'])) {
    return;
}

$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$segments = explode('/', trim($path, '/'));

// GET /inc reads the default counter and POST /inc increments it. Named
// counters use the explicit GET or POST /inc/<name> extension.
if ($segments[0] !== 'inc' || count($segments) > 2) {
    http_response_code(404);
    exit;
}

$name = $segments[1] ?? 'counter';
if (!isPersistentCounterName($name)) {
    http_response_code(404);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    $increment = false;
} elseif ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $increment = true;
} else {
    http_response_code(404);
    exit;
}

header('Content-Type: text/plain');
echo persistentCounterValue($name, $increment);