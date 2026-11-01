//! tauri 的最小替身：只实现 `async_runtime::spawn`。
//!
//! 真实 tauri 的 `async_runtime` 内部就是一个 tokio 运行时，
//! 所以这里用 tokio 的全局运行时实现，行为一致。

pub mod async_runtime {
    use std::sync::OnceLock;
    use tokio::runtime::Runtime;

    fn rt() -> &'static Runtime {
        static RT: OnceLock<Runtime> = OnceLock::new();
        RT.get_or_init(|| {
            tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .expect("创建 tokio 运行时失败")
        })
    }

    pub fn spawn<F>(future: F)
    where
        F: std::future::Future<Output = ()> + Send + 'static,
    {
        rt().spawn(future);
    }
}
