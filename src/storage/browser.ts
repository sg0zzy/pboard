import { createRepository } from "./repository";

export const repository = createRepository(browser.storage.local);
