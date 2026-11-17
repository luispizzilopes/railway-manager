//! Recompila as operações geradas quando um `.graphql` ou o snapshot do schema mudar.
fn main() {
    println!("cargo::rerun-if-changed=graphql");
}
