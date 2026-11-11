import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

// Teach tailwind-merge the custom type scale so `text-body` and `text-ink` do not collide.
const merge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: ['display', 'title', 'heading', 'body', 'small', 'caption'] }],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return merge(clsx(inputs));
}
