const eslintConfig = require('@nina/config-eslint');

module.exports = [
  ...eslintConfig,
  {
    files: ['eslint.config.js'],
    languageOptions: {
      globals: {
        module: 'readonly',
        require: 'readonly',
      },
    },
  },
];
