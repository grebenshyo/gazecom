/**
 * Placeholder substitution for prompt templates.
 *
 * Ported from legacy js/prompts.js. The token vocabularies match exactly so
 * that prompt-list output is bit-for-bit identical to the old app.
 */

export const cartoonCharacters: readonly string[] = [
  "Muppet",
  "Bugs Bunny",
  "Daffy Duck",
  "Tweety Bird",
  "Mickey Mouse",
  "Kermit the Frog",
  "Miss Piggy",
  "Fozzie Bear",
  "Rowlf the Dog",
  "Goofy",
  "Donald Duck",
  "Daisy Duck",
  "Snow White",
  "Dopey",
  "Grumpy",
  "Pluto",
  "Betty Boop",
  "Popeye",
  "Pikachu",
  "Spongebob",
  "Doraemon",
  "Yoda",
  "Snoopy",
  "Homer Simpson",
  "Minnie Mouse",
  "Buzz Lightyear",
  "Calvin",
  "Batman",
  "Robin",
  "Ariel",
  "Woody",
  "Wall-E",
  "Scooby-Doo",
  "Bambi",
  "Thumper",
  "Flower",
  "Porky Pig",
  "Chip",
  "Dale",
  "Gonzo",
  "Elmer Fudd",
  "Pinocchio",
  "Jiminy Cricket",
  "Figaro",
  "Olaf",
  "Sven",
  "Woodstock",
  "Charlie Brown",
];

export const treeParts: readonly string[] = [
  "a tree",
  "trees",
  "tree trunks",
  "tree branches",
];

export const supports: readonly string[] = [
  "paper",
  "background",
  "backdrop",
  "sheet",
];

export const colors: readonly string[] = ["white", "black"];

export const artists: readonly string[] = [
  "Egon Schiele",
  "Van Gogh",
  "Gustav Klimt",
];

const TOKENS: ReadonlyArray<readonly [RegExp, readonly string[]]> = [
  [/\{cartoon character\}/g, cartoonCharacters],
  [/\{tree part\}/g, treeParts],
  [/\{support\}/g, supports],
  [/\{color\}/g, colors],
  [/\{artist\}/g, artists],
];

/**
 * Replace every `{token}` in the template with a random pick from the
 * token's vocabulary. Each occurrence rolls independently.
 *
 * The `rng` parameter is injectable for deterministic tests.
 */
export function replaceAllPlaceholders(
  template: string,
  rng: () => number = Math.random,
): string {
  let out = template;
  for (const [pattern, vocab] of TOKENS) {
    out = out.replace(pattern, () => vocab[Math.floor(rng() * vocab.length)]);
  }
  return out;
}
