"""Leave signal-cli's libsignal-client jar carrying only the JNI library this image loads.

The upstream jar bundles libsignal_jni for linux-amd64, macOS and Windows, and
NOT for linux-aarch64 — the only platform this service is deployed on. On arm64
libsignal's loader therefore finds no `libsignal_jni_aarch64.so` resource and
every command that touches the protocol (`link`, `daemon`) dies with
UnsatisfiedLinkError, while `signal-cli --version` still passes.

Usage: libsignal-jar.py <jar> <java os.arch> [<libsignal_jni.so to embed>]

The embedded library is written under the resource name libsignal's loader asks
for (`libsignal_jni_<os.arch>.so`). Every other native library is dropped: the
amd64 one alone is 133 MB uncompressed and nothing on arm64 can load it.
"""

import os
import sys
import zipfile

NATIVE_SUFFIXES = (".so", ".dylib", ".dll")


def main() -> None:
    jar, arch = sys.argv[1], sys.argv[2]
    extra = sys.argv[3] if len(sys.argv) > 3 else None
    target = f"libsignal_jni_{arch}.so"
    tmp = f"{jar}.tmp"

    with zipfile.ZipFile(jar) as src, zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as dst:
        for item in src.infolist():
            name = item.filename
            if "/" not in name and name.endswith(NATIVE_SUFFIXES):
                if extra is not None or name != target:
                    continue
            dst.writestr(item, src.read(name))
        if extra is not None:
            dst.write(extra, target)
        names = dst.namelist()

    if target not in names:
        os.remove(tmp)
        sys.exit(f"{jar}: no {target} for os.arch={arch}; pass the library to embed")
    os.replace(tmp, jar)
    print(f"{jar}: native libraries reduced to {target}")


if __name__ == "__main__":
    main()
