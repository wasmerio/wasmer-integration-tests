<?php

error_reporting(E_ALL);
ini_set('display_errors', '1');
ini_set('display_startup_errors', '1');

function get_env_or_fail($name)
{
  $result = getenv($name);

  if ($result === false) {
    throw new Exception("Failed to read " . $name . " env var, make sure it is provided to the PHP server", 1);
  }

  return $result;
}

function get_env_or_default($name, $default)
{
  $result = getenv($name);

  return $result == false ? $default : $result;
}

function router()
{
  switch ($_GET["test"]) {
    case "curl":
      test_curl();
      break;

    case "mail":
      test_mail();
      break;

    case "pgsql":
      test_pgsql();
      break;

    case "mysql":
      test_mysql();
      break;

    default:
      die("Unknown test");
  }

  echo "Success";
}

function exec_request($curl)
{
  curl_setopt($curl, CURLOPT_RETURNTRANSFER, 1);
  $result = curl_exec($curl);
  if (curl_error($curl)) {
    die("cURL request failed: " . curl_strerror(curl_errno($curl)));
  }
  curl_close($curl);
  return $result;
}

function test_curl()
{
  $url = "https://winter-tests.wasmer.app/";

  $curl = curl_init($url);
  $result = exec_request($curl);
  assert($result == "GET request successful");

  $curl = curl_init($url);
  $payload = json_encode(array("name" => "PHP"));
  curl_setopt($curl, CURLOPT_POSTFIELDS, $payload);
  curl_setopt($curl, CURLOPT_HTTPHEADER, array('Content-Type:application/json'));
  $result = exec_request($curl);
  // decode and re-encode to make sure we have the same formatting
  assert(json_encode(json_decode($result)) == $payload);
}

function test_mail()
{
  $success = mail('example@example.com', 'My Subject', 'My message');
  if (!$success) {
    $last_error = error_get_last();
    if ($last_error) {
      echo $last_error['message'];
    }
    die("Failed to send mail");
  }
}

class DbConnectionInfo
{
  public $host;
  public $port;
  public $dbname;
  public $username;
  public $password;

  public static function read_from_env($db, $default_port)
  {
    $result = new DbConnectionInfo();
    $result->host = get_env_or_fail($db . "_HOST");
    $result->port = get_env_or_default($db . "_PORT", $default_port);
    $result->dbname = get_env_or_fail($db . "_DBNAME");
    $result->username = get_env_or_fail($db . "_USERNAME");
    $result->password = get_env_or_fail($db . "_PASSWORD");
    return $result;
  }
}

function test_pgsql()
{
  $conn_info = DbConnectionInfo::read_from_env("PG", 5432);

  $table_name = "T" . random_int(0, PHP_INT_MAX);

  $db = pg_connect("host=$conn_info->host:$conn_info->port user=$conn_info->username password=$conn_info->password dbname=$conn_info->dbname sslmode=require")
    or die('Could not connect to PgSql database: ' . pg_last_error());

  pg_exec($db, "CREATE TABLE $table_name (
                  id INTEGER PRIMARY KEY,
                  txt TEXT NOT NULL);");

  pg_exec($db, "INSERT INTO $table_name VALUES (1, 'foo');");
  pg_exec($db, "INSERT INTO $table_name VALUES (2, 'bar');");

  $result = pg_query($db, "SELECT * from $table_name");

  $row = pg_fetch_assoc($result);
  assert($row['id'] == 1);
  assert($row['txt'] == 'foo');

  $row = pg_fetch_assoc($result);
  assert($row['id'] == 2);
  assert($row['txt'] == 'bar');

  assert(!$row = pg_fetch_assoc($result));

  pg_exec($db, "DROP TABLE $table_name");

  pg_close($db);
}

function test_mysql()
{
  $conn_info = DbConnectionInfo::read_from_env("MYSQL", 3306);

  $table_name = "T" . random_int(0, PHP_INT_MAX);

  $mysqli = mysqli_init();

  $cert = getenv('MYSQL_CERT');
  if ($cert !== false) {
    file_put_contents('/mysql-cert.pem', $cert);
    $mysqli->options(MYSQLI_OPT_SSL_VERIFY_SERVER_CERT, true);
    $mysqli->ssl_set(NULL, NULL, "/mysql-cert.pem", NULL, NULL);
  }

  $mysqli->real_connect($conn_info->host, $conn_info->username, $conn_info->password, $conn_info->dbname, $conn_info->port);
  $mysqli->execute_query("CREATE TABLE $table_name (
                          id INTEGER PRIMARY KEY,
                          txt TEXT NOT NULL);");

  $mysqli->execute_query("INSERT INTO $table_name VALUES (1, 'foo');");
  $mysqli->execute_query("INSERT INTO $table_name VALUES (2, 'bar');");

  $result = $mysqli->query("SELECT * from $table_name");

  $row = $result->fetch_assoc();
  assert($row['id'] == 1);
  assert($row['txt'] == 'foo');

  $row = $result->fetch_assoc();
  assert($row['id'] == 2);
  assert($row['txt'] == 'bar');

  assert(!$result->fetch_assoc());

  $mysqli->execute_query("DROP TABLE $table_name");

  $mysqli->close();
}

router();