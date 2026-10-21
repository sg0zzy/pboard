import { describe, expect, it } from "vitest";
import { wordRangeAt } from "../src/sidebar/wordRange";

describe("wordRangeAt", () => {
  it("selects the word the caret sits in", () => {
    expect(wordRangeAt("hello brave world", 2)).toEqual({ start: 0, end: 5 });
    expect(wordRangeAt("hello brave world", 7)).toEqual({ start: 6, end: 11 });
  });

  it("keeps the word when the caret rests on its last character", () => {
    expect(wordRangeAt("hello brave world", 5)).toEqual({ start: 0, end: 5 });
    expect(wordRangeAt("hello brave world", 11)).toEqual({ start: 6, end: 11 });
  });

  it("selects the following word when the caret rests before it", () => {
    expect(wordRangeAt("hello brave world", 6)).toEqual({ start: 6, end: 11 });
  });

  it("selects nothing between words", () => {
    expect(wordRangeAt("hello brave world", 4)).toEqual({ start: 0, end: 5 });
    expect(wordRangeAt("hello, brave", 5)).toEqual({ start: 0, end: 5 });
    expect(wordRangeAt("hello, brave", 6)).toBeNull();
  });

  it("splits words that punctuation separates", () => {
    expect(wordRangeAt("well-known", 2)).toEqual({ start: 0, end: 4 });
    expect(wordRangeAt("well-known", 4)).toEqual({ start: 0, end: 4 });
    expect(wordRangeAt("well-known", 5)).toEqual({ start: 5, end: 10 });
    expect(wordRangeAt("well-known", 6)).toEqual({ start: 5, end: 10 });
  });

  it("keeps contractions and underscores inside one word", () => {
    expect(wordRangeAt("don't stop", 2)).toEqual({ start: 0, end: 5 });
    expect(wordRangeAt("snake_case_name", 7)).toEqual({ start: 0, end: 15 });
  });

  it("selects non-latin words", () => {
    expect(wordRangeAt("say ünïcode now", 5)).toEqual({ start: 4, end: 11 });
  });

  it("returns nothing for empty text and clamps out-of-range offsets", () => {
    expect(wordRangeAt("", 0)).toBeNull();
    expect(wordRangeAt("word", -5)).toEqual({ start: 0, end: 4 });
    expect(wordRangeAt("word", 99)).toEqual({ start: 0, end: 4 });
  });
});
