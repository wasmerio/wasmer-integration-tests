# used for testing "wasmer ssh" subcommand

function err_exit(){
    echo "test failed"
    exit 1
}
pwd
mkdir test
cd test
[ "$(pwd)" == "/test" ] || err_exit
touch x
echo hello > x
[ "$(cat x)" == "hello" ] || err_exit