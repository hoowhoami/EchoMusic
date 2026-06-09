fn main() {
    napi_build::setup();
    #[cfg(target_os = "linux")]
    {
        println!("cargo:rustc-link-arg=-Wl,--exclude-libs,ALL");
    }
}
