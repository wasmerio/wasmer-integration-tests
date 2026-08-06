<?php
// Reports how the serving PHP engine types integers, as JSON.
//
// ECO-426: the phpix 0.3.0-rc.4 64-bit build folds unary negation to `float`,
// so `-1` is a double while `1` and `0 - 1` stay int. Every `int`-typed
// parameter with a negative default then fails to compile, and integer-only
// builtins reject negated values at runtime.
//
// Probes that can raise are guarded so the report always renders and names
// the failure. Compile-time failures cannot be caught here; they live in the
// int-default-*.php fixtures, one literal shape per file.

error_reporting(E_ALL);
ini_set('display_errors', '1');

function probe(callable $fn) {
    try {
        return ['ok' => true, 'value' => $fn()];
    } catch (Throwable $e) {
        return ['ok' => false, 'error' => get_class($e) . ': ' . $e->getMessage()];
    }
}

// 2^40. Fits in a 64-bit int; a legitimate 32-bit build widens it to float.
// This is the shape of WordPress's TB_IN_BYTES (wp-includes/default-constants.php).
$terabyte = 1024 * 1024 * 1024 * 1024;
$one = 1;

$report = [
    'php_version' => PHP_VERSION,
    'php_int_size' => PHP_INT_SIZE,
    'php_int_max' => (string) PHP_INT_MAX,
    'php_int_max_is_int' => is_int(PHP_INT_MAX),

    // ECO-426. Negation must not change the type of an integer.
    'positive_literal_type' => gettype(1),
    'negative_literal_type' => gettype(-1),
    'negated_variable_type' => gettype(-$one),
    'subtraction_type' => gettype(0 - 1),
    'negated_constant_type' => gettype(-PHP_INT_MAX),

    // Width, independent of the sign bug.
    'terabyte_is_int' => is_int($terabyte),
    'terabyte_value' => (string) $terabyte,

    // The builtins that failed in production, fed a negated value.
    'intdiv' => probe(fn() => intdiv($terabyte, 1024 * 1024 * 1024)),
    'array_slice' => probe(fn() => array_slice([1, 2, 3], -$one)),
    'substr' => probe(fn() => substr('abcdef', -$one)),
];

header('Content-Type: application/json');
echo json_encode($report);
