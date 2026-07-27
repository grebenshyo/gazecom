declare module "virtual:gazecom-guide" {
  export const guideHeaderHtml: string;
  export const guideHtml: string;
  export const guideSections: ReadonlyArray<{
    id: string;
    label: string;
  }>;
}
