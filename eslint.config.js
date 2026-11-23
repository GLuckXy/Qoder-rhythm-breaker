import js from '@eslint/js';

const clockBan = {
  selector: "MemberExpression[property.name='time']",
  message: 'T4：判定/调度/定位路径禁用 scene.time，请改用 BeatClock.now()。'
};

export default [
  js.configs.recommended,
  {
    files: ['src/**/*.js', 'tools/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        window: 'readonly',
        document: 'readonly',
        console: 'readonly',
        performance: 'readonly',
        fetch: 'readonly',
        localStorage: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        AudioContext: 'readonly',
        structuredClone: 'readonly',
        process: 'readonly',
        URL: 'readonly',
        navigator: 'readonly'
      }
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-empty': ['warn', { allowEmptyCatch: true }]
    }
  },
  {
    files: ['src/game/**/*.js', 'src/audio/**/*.js', 'src/ui/**/*.js'],
    rules: {
      'no-restricted-syntax': ['error', clockBan],
      'no-restricted-globals': [
        'error',
        { name: 'performance', message: 'T4：禁用 performance.now()，唯一时间真相是 BeatClock.now()。' },
        { name: 'Date', message: 'T4：判定路径禁用 Date.now()，请用 BeatClock.now()。' }
      ]
    }
  },
  {
    ignores: ['dist/**', 'node_modules/**', '.agent/**', 'docs/**']
  }
];
