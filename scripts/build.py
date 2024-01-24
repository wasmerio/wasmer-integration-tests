#!/usr/bin/env python
"""
For all wasmer packages dir `packages`, generate a new name package name in
wasmer.toml, then use that same package name in app.yaml as well.
"""
import os
import logging
import re
import shutil
import io
import uuid
import toml
import yaml
import subprocess


def gen_random_name() -> str:
    name = "-".join(str(uuid.uuid4()).split("-")[:2])
    return f"test-{name}"


def get_default_namespace() -> str:
    proc = subprocess.run("wasmer whoami".split(), capture_output=True)
    assert (
        proc.returncode == 0
    ), f"Failed to run `wasmer whoami`\n{proc.stderr.decode()}"
    out = proc.stdout.decode()
    return re.match(r'.*as user "(\w+)"', out).groups()[0]


class Package:
    namespace: str
    name: str

    def __init__(self, namespace=None, name=None):
        if namespace is None:
            self.namespace = get_default_namespace()
        if name is None:
            self.name = gen_random_name()

    def package_name(self):
        return f"{self.namespace}/{self.name}"

    def app_name(self):
        return self.name


def process_wasmer_toml(wasmer_toml: str, package: Package) -> str:
    data = toml.loads(wasmer_toml)
    data["package"]["name"] = package.package_name()
    return toml.dumps(data)


def process_app_yaml(app_yaml: str, package: Package) -> str:
    app_io = io.BytesIO(initial_bytes=app_yaml.encode())
    data = yaml.load(app_io, yaml.Loader)
    if "app_id" in data.keys():
        data.pop("app_id")
    data["name"] = package.app_name()
    data["package"] = package.package_name()
    return yaml.dump(data)


def process_wasmer_packages(working_dir="packages"):
    for directory_name in os.listdir(working_dir):
        try:
            package = Package()
            path = os.path.join(working_dir, directory_name)
            # process wasmer.toml
            wasmer_toml_path = os.path.join(path, "wasmer.toml")
            wasmer_toml_backup_path = wasmer_toml_path + ".bak"
            if not os.path.exists(wasmer_toml_backup_path):
                shutil.copyfile(wasmer_toml_path, wasmer_toml_backup_path)
            else:
                logging.warning(
                    f"A backup file already exists ({wasmer_toml_backup_path})."
                    "This could mean that another test instance is already running."
                )
            wasmer_toml = open(wasmer_toml_path).read()
            wasmer_toml = process_wasmer_toml(wasmer_toml, package)
            with open(wasmer_toml_path, "w") as f:
                f.write(wasmer_toml)

            # process app.yaml
            app_yaml_path = os.path.join(path, "app.yaml")
            app_yaml_backup_path = app_yaml_path + ".bak"
            if not os.path.exists(app_yaml_backup_path):
                shutil.copyfile(app_yaml_path, app_yaml_backup_path)
            else:
                logging.warning(
                    f"A backup file already exists ({app_yaml_backup_path})."
                    "This could mean that another test instance is already running."
                )
            app_yaml = open(app_yaml_path).read()
            app_yaml = process_app_yaml(app_yaml, package)
            with open(app_yaml_path, "w") as f:
                f.write(app_yaml)
        except Exception as e:
            logging.info(f"{e}")


if __name__ == "__main__":
    import sys

    working_dir = "./packages"
    if len(sys.argv) > 1:
        working_dir = sys.argv[-1]
    process_wasmer_packages(working_dir)
