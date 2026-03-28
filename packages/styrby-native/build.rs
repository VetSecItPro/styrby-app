/// napi-build generates the linker flags required to produce a valid `.node`
/// shared library. Without this build script, the resulting binary would be
/// missing the `napi_module_register` symbol that Node.js looks for when it
/// calls `process.dlopen()`.
///
/// See: https://napi.rs/docs/introduction/getting-started
extern crate napi_build;

fn main() {
    napi_build::setup();
}
