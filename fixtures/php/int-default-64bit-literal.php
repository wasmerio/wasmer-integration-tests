<?php
// Compile-time probe: a literal that needs the full 64-bit int range as the
// default of an `int` parameter. Valid on a 64-bit build; a 32-bit build
// legitimately widens it to float and rejects it, so only assert this file
// on apps built 64-bit.
//
// This is the width check, not ECO-426 — it tells a genuine 32-bit engine
// apart from a 64-bit one that mistypes negation
// (see int-default-negative-literal.php).

function limit_probe(int $limit = 9223372036854775807): int {
    return $limit;
}

echo 'large-literal-ok:' . limit_probe();
