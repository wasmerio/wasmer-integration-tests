<?php

error_reporting(E_ALL);
ini_set('display_errors', '1');
ini_set('display_startup_errors', '1');

function router() {
  $timestamp_path = '/timestamp.txt';
  $header_instaboot = 'HTTP_X_EDGE_INSTABOOT';

  // if instaboot header is set, create timestamp file
  if (isset($_SERVER[$header_instaboot])) {
    $timestamp = time();
    file_put_contents($timestamp_path, $timestamp);
  } else {
    // if timestamp file exists, return timestamp
    if (file_exists($timestamp_path)) {
      $timestamp = file_get_contents($timestamp_path);
      echo $timestamp;
    } else {
      throw new Exception("Timestamp file not found at '$timestamp_path'");
    }
  }
}

router();

?>
