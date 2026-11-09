// Release builds are GUI apps: no console window behind the terminal window.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    switchboard_lib::run()
}
