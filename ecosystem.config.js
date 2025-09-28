module.exports = {
  apps: [{
    name: 'whatsapp-network-site',
    script: 'server-multi-user.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    },
    env_production: {
      NODE_ENV: 'production',
      PORT: process.env.PORT || 3000
    }
  }]
};
