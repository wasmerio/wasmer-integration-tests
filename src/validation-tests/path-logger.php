<?php
 // Get the requested path
$path = $_SERVER['REQUEST_URI'];

// Print the request with a timestamp
echo date('Y-m-d H:i:s') . " - " . $path . "\n";
fwrite(fopen('php://stderr', 'w'),  date('Y-m-d H:i:s') . " - " . $path . "\n");
