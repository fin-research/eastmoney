import "../app.css";
import "../styles.css";
import { mount } from "svelte";
import Site from "./Site.svelte";

mount(Site, { target: document.getElementById("app")! });
