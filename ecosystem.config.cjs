module.exports = {
  apps: [
    {
      name: process.env.F || "cpeak",
      script: `./${process.env.F || "cpeak"}.js`,
      instances: "max",
      exec_mode: "cluster",
      env: {
        NODE_ENV: "production",
        REDIS_CLUSTER: "true",
      },
    },
  ],
};
