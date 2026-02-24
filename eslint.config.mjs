import gnome from 'eslint-config-gnome';
import eslintConfigPrettier from 'eslint-config-prettier';

export default [
    {
        ignores: ['node_modules/**', 'schemas/**', 'resources/**'],
    },
    // GNOME's recommended rules: GNOME JS style guide, GJS globals, formatting
    ...gnome.configs.recommended,
    {
        // ES module source type for GNOME Shell extensions (required for GNOME 45+)
        files: ['**/*.js'],
        languageOptions: {
            sourceType: 'module',
            globals: {
                // GNOME Shell runtime global (display, backend, workspace_manager, etc.)
                global: 'readonly',
            },
        },
    },
    // Disable ESLint formatting rules that conflict with Prettier (must be last)
    eslintConfigPrettier,
];
