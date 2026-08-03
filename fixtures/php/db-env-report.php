<?php
// Reports which managed-database env vars are injected into the app, plus
// their non-secret values (the dashboard shows host/port/name/username; only
// DB_PASSWORD is secret and is reported as a boolean).
//
// Engine-agnostic on purpose: it never opens a database connection, so it
// works for both MySQL and PostgreSQL apps. SQL round trips are done from
// the test runner with the credentials from the GraphQL API.

error_reporting(E_ALL);
ini_set('display_errors', '1');

$path = ltrim($_SERVER['SCRIPT_NAME'], '/');

if ($path !== 'db-env') {
  echo 'Use /db-env for the database environment report';
  return;
}

$required = ['DB_HOST', 'DB_PORT', 'DB_USERNAME', 'DB_PASSWORD', 'DB_NAME'];
$present = [];
$missing = [];
foreach ($required as $name) {
  if (getenv($name) === false) {
    $missing[] = $name;
  } else {
    $present[] = $name;
  }
}

header('Content-Type: application/json');
echo json_encode([
  'present' => $present,
  'missing' => $missing,
  'host' => getenv('DB_HOST') ?: null,
  'port' => getenv('DB_PORT') ?: null,
  'name' => getenv('DB_NAME') ?: null,
  'username' => getenv('DB_USERNAME') ?: null,
  'hasPassword' => getenv('DB_PASSWORD') !== false,
  'hasDatabaseUrl' => getenv('DATABASE_URL') !== false,
  'hasDbEngine' => getenv('DB_ENGINE') !== false,
]);
