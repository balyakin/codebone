use std::fmt;

pub struct Server {
    port: u16,
}

impl Server {
    pub fn start(&self) -> String {
        format!("{}", self.port)
    }
}

pub fn create_server() -> Server {
    Server { port: 8080 }
}
