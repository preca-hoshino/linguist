---
name: mdui-best-practices
description: Best practices for using mdui Web Components in a Vue 3 project. Covers icon usage with on-demand imports, dynamic icon rendering using Vue components, and consistent styling with design tokens.
license: MIT
metadata:
  author: github.com/arts-website
  version: '1.0.0'
compatibility: Requires mdui and Vue 3 project
---

# MDUI Best Practices for Vue 3

Best practices for integrating mdui Web Components into Vue 3 applications, focusing on performance, reactivity, and design consistency.

## Icon Usage

When using mdui with Vue 3 and Vite in an "on-demand" import setup (e.g. `import '@mdui/icons/menu.js'`), avoid the string-based `icon` property.

### Component Slot Approach

Using the `icon` attribute (e.g., `icon="search"`) depends on global Material Icons fonts. Instead, use the specific custom element for the icon inside the component's slot for better performance and smaller bundle sizes.

```vue
<script setup lang="ts">
import '@mdui/icons/search.js'
</script>

<template>
  <!-- ❌ Avoid: Depends on global font assets -->
  <mdui-button-icon icon="search"></mdui-button-icon>

  <!-- ✅ Recommended: Direct icon component usage -->
  <mdui-button-icon>
    <mdui-icon-search></mdui-icon-search>
  </mdui-button-icon>
</template>
```

### Dynamic Icons

For icons that change based on state (e.g., theme toggles), use Vue's `<component :is="...">` syntax to render the appropriate custom element.

```vue
<script setup lang="ts">
import { computed } from 'vue'
import '@mdui/icons/light-mode.js'
import '@mdui/icons/dark-mode.js'

const isDark = ref(false)
const currentIcon = computed(() => (isDark.value ? 'mdui-icon-light-mode' : 'mdui-icon-dark-mode'))
</script>

<template>
  <mdui-button-icon @click="toggle">
    <!-- Ensure the string matches the custom element tag name -->
    <component :is="currentIcon"></component>
  </mdui-button-icon>
</template>
```

## Design Tokens

Always prefer using mdui design tokens (CSS variables) for styling to ensure consistency with the application's theme and automatic dark mode support.

```css
/* ❌ Avoid: Hardcoded colors ignore theme changes */
.title {
  color: #000;
}

/* ✅ Recommended: Design tokens adapt to theme */
.title {
  color: var(--mdui-color-on-surface);
  background-color: var(--mdui-color-surface-container);
}
```
