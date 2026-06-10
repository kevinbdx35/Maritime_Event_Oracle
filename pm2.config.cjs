'use strict'

const path = require('path')
const root = __dirname

/**
 * Maritime Event Oracle — pm2 process config
 *
 * Start all services:  pm2 start pm2.config.cjs
 * Stop all:            pm2 stop meo
 * Restart all:         pm2 restart meo
 * Live logs:           pm2 logs
 * Status:              pm2 status
 *
 * Prerequisites:
 *   1. podman compose up -d        (TimescaleDB + Anvil)
 *   2. pnpm db:migrate             (run once)
 *   3. .env file at repo root      (copy from .env.example)
 */

module.exports = {
  apps: [
    {
      name:        'meo-api',
      script:      'node',
      args:        [
        '--env-file=' + path.join(root, '.env'),
        '--import',    path.join(root, 'node_modules/tsx/dist/esm/index.cjs'),
        'src/index.ts',
      ].join(' '),
      cwd:         path.join(root, 'apps/api'),
      exec_mode:   'fork',
      autorestart: true,
      watch:       false,
      max_restarts: 10,
      restart_delay: 3000,
      env: { NODE_ENV: 'production' },
    },
    {
      name:        'meo-ingestor',
      script:      'node',
      args:        [
        '--env-file=' + path.join(root, '.env'),
        '--import',    path.join(root, 'node_modules/tsx/dist/esm/index.cjs'),
        'src/index.ts',
      ].join(' '),
      cwd:         path.join(root, 'apps/ingestor'),
      exec_mode:   'fork',
      autorestart: true,
      watch:       false,
      max_restarts: 10,
      restart_delay: 5000,
      env: { NODE_ENV: 'production' },
    },
    {
      name:        'meo-anchor-worker',
      script:      'node',
      args:        [
        '--env-file=' + path.join(root, '.env'),
        '--import',    path.join(root, 'node_modules/tsx/dist/esm/index.cjs'),
        'src/index.ts',
      ].join(' '),
      cwd:         path.join(root, 'apps/anchor-worker'),
      exec_mode:   'fork',
      autorestart: true,
      watch:       false,
      max_restarts: 10,
      restart_delay: 10000,
      env: { NODE_ENV: 'production' },
    },
  ],
}
