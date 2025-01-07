<?php
// This is extracted to its own file to allow LSP integrations and smaller
// context for LLM prompts

error_reporting(E_ALL);
ini_set('display_errors', '1');
ini_set('display_startup_errors', '1');

$path = ltrim($_SERVER['SCRIPT_NAME'], '/');

function checkRequiredSqlEnvVars()
{
  $requiredEnvVars = ['DB_HOST', 'DB_PORT', 'DB_USERNAME', 'DB_PASSWORD', 'DB_NAME'];
  $missingEnvVars = array_filter($requiredEnvVars, function ($envVar) {
    return getenv($envVar) === false;
  });

  if (!empty($missingEnvVars)) {
    return "Missing required SQL environment variables: " . implode(', ', $missingEnvVars);
  } else {
    return "OK";
  }
}


function listAllEnvVars()
{
  $envVars = getenv();
  $envVarList = [];
  foreach ($envVars as $key => $value) {
    $envVarList[] = "$key => $value";
  }
  return implode("\n", $envVarList);
}

function checkSqlConnection()
{
  $envVarCheck = checkRequiredSqlEnvVars();
  if ($envVarCheck !== "OK") {
    return $envVarCheck . "\nAll environment variables:\n" . listAllEnvVars();
  }

  $servername = getenv('DB_HOST') . getenv('DB_PORT');
  $username = getenv('DB_USERNAME');
  $password = getenv('DB_PASSWORD');
  $dbname = getenv('DB_NAME');

  // Create connection
  $conn = new mysqli($servername, $username, $password, $dbname);


  // TODO: Security checks to validate that it's not possible to connect to 
  // any other DB than the specified one (requires a bit of architecture knowledge)
  if ($conn->connect_error) {
    return "Connection failed: " . $conn->connect_error;
  } else {
    return "OK";
  }
}

if ($path === 'results') {
  echo checkSqlConnection();
} else {
  echo 'Use /results to check SQL connectivity';
}
