import { createRepository } from "./repository";
import { browser } from "../platform/browser";

export const repository = createRepository(browser.storage.local);
