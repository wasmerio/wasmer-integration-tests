#!/usr/bin/env python
"""
For all wasmer packages dir `packages`, generate a new name package name in
wasmer.toml, then use that same package name in app.yaml as well.
"""
import os
import logging
import shutil


def process_wasmer_packages(working_dir="packages"):
    for directory_name in os.listdir(working_dir):
        try:
            path = os.path.join(working_dir, directory_name)
            # process wasmer.toml
            wasmer_toml_path = os.path.join(path, "wasmer.toml")
            wasmer_toml_backup_path = wasmer_toml_path + ".bak"
            if os.path.exists(wasmer_toml_backup_path):
                shutil.move(wasmer_toml_backup_path, wasmer_toml_path)

            # process app.yaml
            app_yaml_path = os.path.join(path, "app.yaml")
            app_yaml_backup_path = app_yaml_path + ".bak"
            if os.path.exists(app_yaml_backup_path):
                shutil.move(app_yaml_backup_path, app_yaml_path)
        except Exception as e:
            logging.info(f"{e}")


if __name__ == "__main__":
    import sys

    working_dir = "./packages"
    if len(sys.argv) > 1:
        working_dir = sys.argv[-1]
    process_wasmer_packages(working_dir)
