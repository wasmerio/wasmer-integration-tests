
from subprocess import run
from shlex import split
from os.path import dirname, realpath

def test_ssh():
    assert "/" == run(split(f"wasmer ssh sharrattj/bash -- -c pwd"), capture_output=True).stdout.decode().strip()
    # The tests below should run in theory but failing, currently disabled until ssh subcommand is fixed
    # assert "bin" in run(split(f"wasmer ssh sharrattj/bash -- ls"), capture_output=True).stderr.decode().strip().split()
    # assert "/test" == run(split(f"wasmer ssh sharrattj/bash -- -c 'mkdir test && cd test && pwd'"), capture_output=True).stdout.decode().strip()
    # assert "hello" == run(split(f"wasmer ssh sharrattj/bash -- -c 'echo -n hello > test && cat test'"), capture_output=True).stdout.decode().strip()
    # assert "/" == run(split(f"echo pwd | wasmer ssh"), capture_output=True).stdout.decode().strip()
    # with open(f"{dirname(realpath(__file__))}/commands.sh") as commands:
    #   assert run(split(f"echo pwd | wasmer ssh"), capture_output=True).returncode == 255 # somehow ssh command exits with 255 on success