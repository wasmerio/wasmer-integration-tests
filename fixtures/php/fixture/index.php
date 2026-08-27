<?php
// PHP implementation of the fixture contract (fixtures/openapi.yaml).
// HTTP-only: the phpix engine does not hold upgraded WebSockets, so the
// asyncapi.yaml channel is not implemented and /ws only answers 426.
// Served as the docroot index.php of phpix, whose clean-URL routing
// dispatches every non-file path here; no framework, no composer deps.

error_reporting(E_ALL);
ini_set('display_errors', '1');

const REQUIRED_DB_VARS = ['DB_HOST', 'DB_PORT', 'DB_USERNAME', 'DB_PASSWORD', 'DB_NAME'];
const COUNTER_NAME_PATTERN = '/^[a-z-]+$/';

// Replaced per deployment by the test harness, like the other fixtures.
const UNIQUE_HASH = '__TEMPLATE__';

function dataDir(): string
{
    return getenv('DATA_DIR') ?: '/data';
}

function jsonResponse(array $body, int $status = 200): void
{
    http_response_code($status);
    header('Content-Type: application/json');
    echo json_encode($body, JSON_UNESCAPED_SLASHES);
}

function textResponse(string $body, int $status = 200): void
{
    http_response_code($status);
    header('Content-Type: text/plain');
    echo $body;
}

// --- database-environment ---------------------------------------------------

function dbEnvReport(): array
{
    $present = [];
    $missing = [];
    foreach (REQUIRED_DB_VARS as $name) {
        if (getenv($name) === false) {
            $missing[] = $name;
        } else {
            $present[] = $name;
        }
    }
    return [
        'present' => $present,
        'missing' => $missing,
        'host' => getenv('DB_HOST') !== false ? getenv('DB_HOST') : null,
        'port' => getenv('DB_PORT') !== false ? getenv('DB_PORT') : null,
        'name' => getenv('DB_NAME') !== false ? getenv('DB_NAME') : null,
        'username' => getenv('DB_USERNAME') !== false ? getenv('DB_USERNAME') : null,
        'hasPassword' => getenv('DB_PASSWORD') !== false,
        'hasDatabaseUrl' => getenv('DATABASE_URL') !== false,
        'hasDbEngine' => getenv('DB_ENGINE') !== false,
    ];
}

// --- database-connectivity --------------------------------------------------

function dbEngine(): ?string
{
    $engine = strtolower(getenv('DB_ENGINE') ?: '');
    if (str_contains($engine, 'postgres') || str_contains($engine, 'pg')) {
        return 'postgres';
    }
    if (str_contains($engine, 'mysql') || str_contains($engine, 'maria')) {
        return 'mysql';
    }
    $url = getenv('DATABASE_URL') ?: '';
    if (str_starts_with($url, 'postgres')) {
        return 'postgres';
    }
    if (str_starts_with($url, 'mysql')) {
        return 'mysql';
    }
    // Managed apps get neither DB_ENGINE nor DATABASE_URL, only DB_*.
    // Hostname contract: PostgreSQL endpoints live under psql.<region>,
    // MySQL under db.<region>/mysql.<region>.
    $host = getenv('DB_HOST') ?: '';
    if (str_starts_with($host, 'psql.')) {
        return 'postgres';
    }
    if (str_starts_with($host, 'db.') || str_starts_with($host, 'mysql.')) {
        return 'mysql';
    }
    if (getenv('DB_PORT') === '5432') {
        return 'postgres';
    }
    if (getenv('DB_PORT') === '3306') {
        return 'mysql';
    }
    // No engine signal (e.g. local platform: raw IP host, remapped port).
    return null;
}

function connectPostgres(): void
{
    if (!function_exists('pg_connect')) {
        throw new Exception('pgsql extension unavailable in this runtime');
    }
    $base = sprintf(
        "host='%s' port='%s' user='%s' password='%s' dbname='%s' connect_timeout=10",
        addslashes(getenv('DB_HOST')),
        addslashes(getenv('DB_PORT')),
        addslashes(getenv('DB_USERNAME')),
        addslashes(getenv('DB_PASSWORD')),
        addslashes(getenv('DB_NAME')),
    );
    // TLS first (managed endpoints enforce sslmode=require), plaintext
    // fallback for TLS-less endpoints like the local platform.
    foreach (['require', 'disable'] as $sslmode) {
        $conn = @pg_connect("$base sslmode=$sslmode", PGSQL_CONNECT_FORCE_NEW);
        if ($conn !== false) {
            pg_close($conn);
            return;
        }
    }
    $error = error_get_last();
    throw new Exception($error['message'] ?? 'pg_connect failed');
}

function connectMysql(): void
{
    if (!class_exists('mysqli')) {
        throw new Exception('mysqli extension unavailable in this runtime');
    }
    mysqli_report(MYSQLI_REPORT_OFF);
    $conn = mysqli_init();
    $conn->options(MYSQLI_OPT_CONNECT_TIMEOUT, 10);
    $connected = @$conn->real_connect(
        getenv('DB_HOST'),
        getenv('DB_USERNAME'),
        getenv('DB_PASSWORD'),
        getenv('DB_NAME'),
        (int) getenv('DB_PORT'),
    );
    if (!$connected) {
        throw new Exception($conn->connect_error ?: 'mysqli connect failed');
    }
    $conn->close();
}

function checkDbConnection(): string
{
    $report = dbEnvReport();
    if (!empty($report['missing'])) {
        return 'Missing required SQL environment variables: ' . implode(', ', $report['missing']);
    }

    // When the engine is ambiguous, probe postgres first: it fails fast
    // against a MySQL server, while a MySQL client waits out its whole
    // connect timeout against PostgreSQL (both protocols expect the peer
    // to speak first).
    $engine = dbEngine();
    $candidates = $engine !== null ? [$engine] : ['postgres', 'mysql'];
    $errors = [];
    foreach ($candidates as $candidate) {
        try {
            if ($candidate === 'postgres') {
                connectPostgres();
            } else {
                connectMysql();
            }
            return 'OK';
        } catch (Throwable $err) {
            $errors[] = "$candidate: " . $err->getMessage();
        }
    }
    return 'Connection failed: ' . implode('; ', $errors);
}

// --- durable-state ----------------------------------------------------------

// phpix runs a pool of PHP worker threads, so an exclusive lock serialises
// increments inside this instance. It does not reach the other instances
// sharing the volume, so the write itself has to be atomic as well. The lock
// lives on its own file because rename() swaps the counter's inode out.
function counterValue(string $name, bool $increment): int
{
    $file = dataDir() . '/' . $name;
    $lock = fopen(dataDir() . '/.lock-' . $name, 'c');
    if ($lock === false || !flock($lock, LOCK_EX)) {
        throw new Exception('Failed to access durable counter storage');
    }
    try {
        $value = 0;
        clearstatcache(true, $file);
        if (is_file($file)) {
            $raw = trim((string) file_get_contents($file));
            // A torn read must not look like a fresh counter, or the file gets
            // reset to 1 and every concurrent probe sees it go backwards.
            if (!preg_match('/^\d+$/', $raw)) {
                throw new Exception("counter $name holds a non-integer value: $raw");
            }
            $value = (int) $raw;
        }
        if ($increment) {
            $value++;
            // Instances on other nodes read this file concurrently and rename
            // is atomic, so none can observe the truncated intermediate.
            $tmp = $file . '.' . getmypid() . '.' . hrtime(true) . '.tmp';
            if (file_put_contents($tmp, (string) $value) === false || !rename($tmp, $file)) {
                @unlink($tmp);
                throw new Exception('Failed to access durable counter storage');
            }
        }
        return $value;
    } finally {
        flock($lock, LOCK_UN);
        fclose($lock);
    }
}

function handleCounter(array $segments, string $method): void
{
    $name = $segments[1] ?? 'counter';
    if (count($segments) > 2 || preg_match(COUNTER_NAME_PATTERN, $name) !== 1) {
        textResponse('Not Found', 404);
        return;
    }
    if ($method === 'GET') {
        $increment = false;
    } elseif ($method === 'POST') {
        $increment = true;
    } else {
        textResponse('Not Found', 404);
        return;
    }
    try {
        textResponse((string) counterValue($name, $increment));
    } catch (Throwable $err) {
        textResponse('Failed to access durable counter storage', 500);
    }
}

// --- outbound-http ----------------------------------------------------------

// The two endpoints exercise PHP's two distinct native network stacks:
// /sync uses the blocking stream wrapper (file_get_contents) and /async
// uses curl's non-blocking multi interface.
function blockingRequest(string $method, string $target, float $timeoutMs): array
{
    $context = stream_context_create([
        'http' => [
            'method' => $method,
            'timeout' => $timeoutMs / 1000,
            'ignore_errors' => true,
            'follow_location' => 0,
        ],
        'ssl' => ['verify_peer' => false, 'verify_peer_name' => false],
    ]);
    $body = @file_get_contents($target, false, $context);
    if ($body === false) {
        $error = error_get_last();
        throw new Exception($error['message'] ?? "request to $target failed");
    }
    $statusLine = $http_response_header[0] ?? '';
    if (preg_match('#^HTTP/\S+\s+(\d+)#', $statusLine, $matches) !== 1) {
        throw new Exception("unparseable status line: $statusLine");
    }
    return ['body' => $body, 'status_code' => (int) $matches[1]];
}

function nonBlockingRequest(string $method, string $target, float $timeoutMs): array
{
    if (!function_exists('curl_multi_init')) {
        throw new Exception('curl extension unavailable in this runtime');
    }
    $handle = curl_init();
    curl_setopt_array($handle, [
        CURLOPT_URL => $target,
        CURLOPT_CUSTOMREQUEST => $method,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT_MS => (int) $timeoutMs,
        CURLOPT_CONNECTTIMEOUT_MS => (int) $timeoutMs,
        CURLOPT_SSL_VERIFYPEER => false,
        CURLOPT_SSL_VERIFYHOST => 0,
    ]);
    $multi = curl_multi_init();
    curl_multi_add_handle($multi, $handle);
    do {
        $status = curl_multi_exec($multi, $active);
        if ($active) {
            curl_multi_select($multi, 0.05);
        }
    } while ($active && $status === CURLM_OK);
    // In multi mode the per-transfer result only surfaces here, never via
    // curl_error.
    $result = CURLE_OK;
    while (($info = curl_multi_info_read($multi)) !== false) {
        if ($info['handle'] === $handle) {
            $result = $info['result'];
        }
    }
    $body = curl_multi_getcontent($handle);
    $statusCode = (int) curl_getinfo($handle, CURLINFO_RESPONSE_CODE);
    curl_multi_remove_handle($multi, $handle);
    curl_multi_close($multi);
    curl_close($handle);
    if ($result !== CURLE_OK) {
        throw new Exception(curl_strerror($result) ?: "curl error $result");
    }
    return ['body' => (string) $body, 'status_code' => $statusCode];
}

function handleProxy(string $mode): void
{
    $start = microtime(true);
    $elapsed = fn(): int => (int) round((microtime(true) - $start) * 1000);
    try {
        $payload = json_decode(file_get_contents('php://input'), true, 512, JSON_THROW_ON_ERROR);
        $result = $mode === 'async'
            ? nonBlockingRequest($payload['method'], $payload['target'], $payload['timeout_ms'])
            : blockingRequest($payload['method'], $payload['target'], $payload['timeout_ms']);
        jsonResponse($result + ['elapsed_time_ms' => $elapsed()]);
    } catch (Throwable $err) {
        jsonResponse([
            'error' => $err->getMessage(),
            'status_code' => 500,
            'elapsed_time_ms' => $elapsed(),
        ]);
    }
}

// --- self-test --------------------------------------------------------------

// Aggregate probe endpoint (openapi.yaml selfTest): every inside-runnable
// contract check in one report, 200 only when all pass. No check opens a
// connection back to the instance — guest loopback is not routable on Edge.
function checkExpect(bool $condition, string $message): void
{
    if (!$condition) {
        throw new Exception($message);
    }
}

function runCheck(string $name, callable $fn): array
{
    $start = microtime(true);
    $elapsed = fn(): int => (int) round((microtime(true) - $start) * 1000);
    try {
        $fn();
        return ['name' => $name, 'ok' => true, 'elapsed_ms' => $elapsed()];
    } catch (Throwable $err) {
        return [
            'name' => $name,
            'ok' => false,
            'elapsed_ms' => $elapsed(),
            'error' => $err->getMessage(),
        ];
    }
}

// The shared counters cannot be asserted from a probe: every instance on the
// volume increments them concurrently, and the volume gives no cross-node
// read coherence, so no invariant over their value holds however the write is
// implemented. Sharing and restart durability stay in the contract suite,
// which controls the environment.
//
// A counter nobody else can name is enough to prove the volume round-trips a
// write: the second increment can only read 2 if the first one persisted and
// came back. Removed afterwards, so probing leaves nothing behind.
function probeCounterName(): string
{
    $suffix = '';
    for ($i = 0; $i < 12; $i++) {
        $suffix .= chr(97 + random_int(0, 25));
    }
    return "self-test-$suffix";
}

function checkDurableCounter(): void
{
    $name = probeCounterName();
    try {
        $first = counterValue($name, true);
        $second = counterValue($name, true);
        checkExpect(
            $first === 1 && $second === 2,
            "durable counter did not round-trip: expected 1 then 2, got $first then $second",
        );
    } finally {
        @unlink(dataDir() . '/' . $name);
        @unlink(dataDir() . '/.lock-' . $name);
    }
}

function handleSelfTest(): void
{
    $checks = [];

    $checks[] = runCheck('db-env', function (): void {
        $report = dbEnvReport();
        checkExpect(
            count($report['present']) + count($report['missing']) === count(REQUIRED_DB_VARS),
            'db-env report does not partition the required vars',
        );
        checkExpect(
            empty($report['present']) || empty($report['missing']),
            'partial DB_* injection: missing ' . implode(', ', $report['missing']),
        );
    });
    $checks[] = runCheck('db-connect', function (): void {
        $result = checkDbConnection();
        if (empty(dbEnvReport()['missing'])) {
            checkExpect($result === 'OK', $result);
        } else {
            checkExpect(
                str_starts_with($result, 'Missing required SQL environment variables'),
                $result,
            );
        }
    });
    $checks[] = runCheck('counter-durability', fn() => checkDurableCounter());
    $checks[] = runCheck('counter-invalid-name', function (): void {
        checkExpect(
            preg_match(COUNTER_NAME_PATTERN, 'NOT-VALID') !== 1
                && preg_match(COUNTER_NAME_PATTERN, 'self-test') === 1,
            'counter name validation does not enforce ^[a-z-]+$',
        );
    });
    $checks[] = runCheck('echo', function (): void {
        $payload = echoPayload('/self-test/echo/');
        checkExpect(
            $payload['echo'] === 'self-test/echo',
            'echo did not strip surrounding slashes: ' . $payload['echo'],
        );
        checkExpect(
            is_string($payload['unique_hash']) && $payload['unique_hash'] !== '',
            'unique_hash is empty',
        );
    });

    $ok = array_reduce($checks, fn($carry, $check) => $carry && $check['ok'], true);
    jsonResponse(
        ['ok' => $ok, 'checks' => $checks, 'unique_hash' => UNIQUE_HASH],
        $ok ? 200 : 500,
    );
}

// --- catch-all --------------------------------------------------------------

function echoPayload(string $pathname): array
{
    return ['echo' => trim($pathname, '/'), 'unique_hash' => UNIQUE_HASH];
}

function handleEcho(string $pathname, string $url): void
{
    // PHP's stdout is the response body, so the log line goes to stderr
    // only; the platform's log pipeline collects it from there.
    $line = date('Y-m-d H:i:s') . " - $url\n";
    fwrite(fopen('php://stderr', 'w'), $line);
    jsonResponse(echoPayload($pathname));
}

// --- router -----------------------------------------------------------------

$url = $_SERVER['REQUEST_URI'];
$pathname = parse_url($url, PHP_URL_PATH) ?: '/';
$segments = array_values(array_filter(explode('/', $pathname), fn($s) => $s !== ''));
$method = $_SERVER['REQUEST_METHOD'];

if ($pathname === '/' && $method === 'GET') {
    jsonResponse(['message' => 'Hello World']);
} elseif ($pathname === '/db-env' && $method === 'GET') {
    jsonResponse(dbEnvReport());
} elseif ($pathname === '/results' && $method === 'GET') {
    textResponse(checkDbConnection());
} elseif (($segments[0] ?? null) === 'inc') {
    handleCounter($segments, $method);
} elseif ($pathname === '/async' && $method === 'POST') {
    handleProxy('async');
} elseif ($pathname === '/sync' && $method === 'POST') {
    handleProxy('sync');
} elseif ($pathname === '/self-test' && $method === 'GET') {
    // Excluded from the catch-all and never logged, like /ws.
    handleSelfTest();
} elseif ($pathname === '/ws') {
    // Reserved by fixtures/asyncapi.yaml, unimplemented on php -S: refused
    // without an upgrade, and never logged.
    textResponse('Upgrade Required', 426);
} elseif ($method === 'GET') {
    handleEcho($pathname, $url);
} else {
    textResponse('Not Found', 404);
}
