<?php
// Compile-time probe for ECO-426: a negative integer literal as the default of
// an `int` parameter. Valid on every correct PHP build, 32-bit and 64-bit.
//
// The phpix 0.3.0-rc.4 64-bit build folds `-1` to a float and refuses to
// compile the file, which is what took WordPress sites down in prod:
//
//   PHP Fatal error: Cannot use float as default value for parameter $lineno
//   of type int in .../twig/src/Extension/CoreExtension.php on line 814
//   PHP Fatal error: Cannot use float as default value for parameter $limit
//   of type int in .../google-listings-and-ads/src/Product/ProductRepository.php

function limit_probe(int $limit = -1): int {
    return $limit;
}

echo 'negative-literal-ok:' . limit_probe();
