// @ts-nocheck
export const unitK = (S: number) => (S >= 5 ? 1.12 : S >= 4 ? 1.06 : 1 + 0.12 * (S - 1));
