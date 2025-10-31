module.exports = {
  apps: [
    {
      name: "dev-etag(port:8777)",
      script: "npm run start",
      env: {
        NODE_ENV: "development",
      },
    },
  ],
};
