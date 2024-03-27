from pytest import fixture
from uuid import uuid4
from subprocess import run
from requests import get
from time import sleep

def app_hostname(appname):
    return f"{appname}-cypress1.wasmer.app"

def app_ping(appname):
    assert 200 == get("http://localhost", headers={"Host": app_hostname(appname)}).status_code

def wait_until_app_ready(appname):
    i = 5
    while i > 0: 
        status = get("http://localhost", headers={"Host": app_hostname(appname)}, timeout=30).status_code
        if status == 200:
            return
        sleep(3)
        i -= 1
    assert False

@fixture
def app_package():
    run(f"wasmer publish --registry http://localhost:8080/graphql --token wap_default_token", cwd="packages/static-web-server", shell=True)
    run(f"wasmer publish --registry http://localhost:8080/graphql --token wap_default_token", cwd="packages/test-app", shell=True)
    yield
    # TODO: Delete package when cli implememts it

@fixture
def app(app_package, tmpdir):
    name = uuid4()
    run(f"wasmer app create --registry http://localhost:8080/graphql --token wap_default_token --non-interactive --type http --package cypress1/test-app@0.2.0 --owner cypress1 --name {name} --no-wait", shell=True, cwd=tmpdir).check_returncode()
    # assert 200 == get("http://localhost", headers={"Host": app_hostname(name)}).status_code
    yield name
    run(f"wasmer app delete --registry http://localhost:8080/graphql --token wap_default_token cypress1/{name}", shell=True).check_returncode()
    
def test_restart_instance(app):
    wait_until_app_ready(app)
    sleep(35)
    app_ping(app)