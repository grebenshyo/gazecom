/**
 * Built-in prompt lists.
 *
 * Ported from legacy js/prompts.js. Templates are stored verbatim — the
 * placeholder substitution happens at use time via
 * `replaceAllPlaceholders`.
 */

export const classicArtMashups: readonly string[] = [
  "{cartoon character} with a Pearl Earring, painting by Vermeer",
  "{cartoon character} as the 'Mona Lisa', painting by Leonardo da Vinci",
  "{cartoon character} amidst 'The Starry Night', painting by Vincent van Gogh",
  "{cartoon character} in 'The Persistence of Memory', painting by Salvador Dalí",
  "{cartoon character} riding the crest of 'The Great Wave off Kanagawa', painting by Hokusai",
  "{cartoon character} standing stoic in 'American Gothic', painting by Grant Wood",
  "{cartoon character} reborn as 'The Birth of Venus', painting by Botticelli",
  "{cartoon character} screaming under 'The Scream', painting by Edvard Munch",
  "{cartoon character} at 'The Last Supper', painting by Leonardo da Vinci",
  "{cartoon character} fragmented in 'Guernica', painting by Pablo Picasso",
];

export const secessionTreesArt: readonly string[] = [
  "Simple, expressive, minimalist line art of {tree part}, pencil drawing on {color} {support} in style of {artist}",
  "Simple, expressive, minimalist line art of {tree part}, pencil drawing on white {support} in style of {artist}",
  "Simple, expressive, minimalist line art of {tree part}, pencil drawing on black {support} in style of {artist}",
  "{color} background, abstract expressionism, art of straight, thin trunks, line art tree trunks in style by egon schiele, gustav klimt and van gogh, close up",
];

export const miscellaneousPrompts: readonly string[] = [
  "colorful camouflage pattern on white background",
];

export type PromptListName =
  | "Classic Art Mashups"
  | "Secession Trees Art"
  | "Miscellaneous";

export const promptLists: Record<PromptListName, readonly string[]> = {
  "Classic Art Mashups": classicArtMashups,
  "Secession Trees Art": secessionTreesArt,
  Miscellaneous: miscellaneousPrompts,
};

export const PROMPT_LIST_NAMES: readonly PromptListName[] = [
  "Classic Art Mashups",
  "Secession Trees Art",
  "Miscellaneous",
];
