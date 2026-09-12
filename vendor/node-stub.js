// wasm-zstd's Emscripten glue imports fs and path for its Node branch, which never
// runs in a browser. These stubs exist only so the bundler has something to resolve.
export default {};
export const readFileSync = null;
export const dirname = (p) => p;
export const join = (...a) => a.join("/");
