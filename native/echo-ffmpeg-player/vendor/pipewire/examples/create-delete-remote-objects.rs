use pipewire as pw;
use pw::types::ObjectType;
use std::{
    cell::{Cell, OnceCell},
    rc::Rc,
};

fn main() {
    // Initialize library and get the basic structures we need.
    pw::init();
    let mainloop =
        pw::main_loop::MainLoopRc::new(None).expect("Failed to create Pipewire Mainloop");
    let context =
        pw::context::ContextRc::new(&mainloop, None).expect("Failed to create Pipewire Context");
    let core = context
        .connect_rc(None)
        .expect("Failed to connect to Pipewire Core");
    let registry = core.get_registry().expect("Failed to get Registry");

    // Setup a registry listener that will obtain the name of a link factory and write it into `factory`.
    let factory: Rc<OnceCell<String>> = Rc::new(OnceCell::new());
    let factory_clone = factory.clone();
    let mainloop_clone = mainloop.clone();
    let reg_listener = registry
        .add_listener_local()
        .global(move |global| {
            if let Some(props) = global.props {
                // Check that the global is a factory that creates the right type.
                if props.get("factory.type.name") == Some(ObjectType::Link.to_str()) {
                    let factory_name = props.get("factory.name").expect("Factory has no name");
                    factory_clone
                        .set(factory_name.to_owned())
                        .expect("Factory name already set");
                    // We found the factory we needed, so quit the loop.
                    mainloop_clone.quit();
                }
            }
        })
        .register();

    // Process all pending events to get the factory.
    do_roundtrip(&mainloop, &core);

    // Now that we have our factory, we are no longer interested in any globals from the registry,
    // so we unregister the listener by dropping it.
    std::mem::drop(reg_listener);

    // Now that we have the name of a link factory, we can create an object with it!
    let link = core
        .create_object::<pw::link::Link>(
            factory.get().expect("No link factory found"),
            &pw::properties::properties! {
                "link.output.port" => "1",
                "link.input.port" => "2",
                "link.output.node" => "3",
                "link.input.node" => "4",
                // Don't remove the object on the remote when we destroy our proxy.
                "object.linger" => "1"
            },
        )
        .expect("Failed to create object");

    // Do another roundtrip so that the link gets created on the server side.
    do_roundtrip(&mainloop, &core);

    // We have our object, now manually destroy it on the remote again.
    core.destroy_object(link).expect("destroy object failed");

    // Do a final roundtrip to destroy the link on the server side again.
    do_roundtrip(&mainloop, &core);
}

/// Do a single roundtrip to process all events.
/// See the example in roundtrip.rs for more details on this.
fn do_roundtrip(mainloop: &pw::main_loop::MainLoopRc, core: &pw::core::CoreRc) {
    let done = Rc::new(Cell::new(false));
    let done_clone = done.clone();
    let loop_clone = mainloop.clone();

    // Trigger the sync event. The server's answer won't be processed until we start the main loop,
    // so we can safely do this before setting up a callback. This lets us avoid using a Cell.
    let pending = core.sync(0).expect("sync failed");

    let _listener_core = core
        .add_listener_local()
        .done(move |id, seq| {
            if id == pw::core::PW_ID_CORE && seq == pending {
                done_clone.set(true);
                loop_clone.quit();
            }
        })
        .register();

    while !done.get() {
        mainloop.run();
    }
}
