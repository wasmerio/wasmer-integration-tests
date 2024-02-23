from uuid import uuid4
from requests import post, get
import json
from urllib.request import urlretrieve
import tarfile
from tempfile import mkdtemp
from subprocess import run
import os
from time import sleep
from pytest import fixture

def test_winterjs(tmpdir):
    tmpdir = "tmp/"
    # Download winterjs webc package from prod registry
    download_url = json.loads(
        post('https://registry.wasmer.io/graphql', 
            json={"query":"{\n  getPackageVersion(name:\"wasmer/winterjs\") {\n    id\n    distribution{\n      downloadUrl\n    }\n  }\n}"}, 
            headers={"Content-Type": "application/json"}
        ).text
    )["data"]["getPackageVersion"]["distribution"]["downloadUrl"]

    # Unpack
    urlretrieve(download_url, f"{tmpdir}/winterjs.webc")
    with tarfile.open(f"{tmpdir}/winterjs.webc", 'r:gz') as _file:
        _file.extractall(tmpdir)

    # Clone winterjs test suite and build it
    run("git clone https://github.com/wasmerio/winterjs.git", shell=True, cwd=tmpdir).check_returncode()
    run("git checkout winterjs-test-suite-in-edge", shell=True, cwd=f"{tmpdir}/winterjs").check_returncode()
    run("npm install", shell=True, cwd=f"{tmpdir}/winterjs/test-suite/js-test-app").check_returncode()
    run("npm run build", shell=True, cwd=f"{tmpdir}/winterjs/test-suite/js-test-app").check_returncode()

    # Create and publish winterjs package bundled with test suite
    with open(f"{tmpdir}/wapm.toml") as _file:
        content = _file.read()

    content = content.replace("""
[[command]]
name = 'wasmer-winter'
module = 'winterjs'""","")
    
    content = content.replace("""
[[command]]
name = 'winterjs'
module = 'winterjs'""","""
[[command]]
name = 'winterjs'
module = 'winterjs'
runner = 'wasi'
""")
    
    content += """
[command.annotations.wasi]
main-args = ["/build/bundle.js"]

[fs]
"/build" = "./winterjs/test-suite/js-test-app/dist/"
    """
    with open(f"{tmpdir}/wasmer.toml", "w") as _file:
        _file.write(content)
    run(f"wasmer publish --registry http://localhost:8080/graphql --package-name cypress1/winterjs_test_suite --token wap_default_token", shell=True, cwd=tmpdir)

    app_name = uuid4()
    with open(f"{tmpdir}/app.yaml", 'w') as _file:
        _file.write(f"""
---
kind: wasmer.io/App.v0
name: {app_name}
package: cypress1/winterjs_test_suite
                    """)
    
    run(f"wasmer deploy --registry http://localhost:8080/graphql --token wap_default_token --no-wait", shell=True, cwd=tmpdir).check_returncode()
    i = 5
    while i > 0:
        resp = get("http://localhost", headers={"Host": f"{app_name}.wasmer.app"})
        if resp.status_code == 404 and "Route Not Found" in resp.text:
            break
        i = i -1
    else:
        raise Exception("winterjs test suite app is not accessible after 5 tries")
    app_name = "be9b97bb-c1dc-486a-b85b-4423be662ec6"
    test_env =  os.environ.copy()
    test_env["PORT"] = "80"
    test_env["WINTERJS_APP_HOSTNAME"] = f"{app_name}.wasmer.app"
    run(f"cargo run .", shell=True, env=test_env, cwd=f"{tmpdir}/winterjs/test-suite/").check_returncode()