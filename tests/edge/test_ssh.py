
from subprocess import run
from shlex import split
from os.path import dirname, realpath

def test_ssh():
    assert "/" == run(split(f"wasmer ssh sharrattj/bash -- -c pwd"), capture_output=True).stdout.decode().strip()
    assert "/" == run(f"echo pwd | wasmer ssh", shell=True, capture_output=True).stdout.decode().strip()
    assert "bin" in run(split(f"wasmer ssh sharrattj/bash -- -c ls"), capture_output=True).stdout.decode().strip().split()
    assert "/test" == run(f"echo 'mkdir test && cd test && pwd' | wasmer ssh",shell=True, capture_output=True).stdout.decode().strip()
    assert "hello" == run(f"echo 'echo -n hello > test && cat test' | wasmer ssh", shell=True, capture_output=True).stdout.decode().strip()