# For MCP directories (Glama) that start the server to list its tools.
# For real use run stackhint locally (npx -y github:Protemir/stackhint): inside a container it
# cannot see your project or your Claude Code and Codex configs.
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY dist ./dist
COPY registry ./registry
COPY skills ./skills
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["mcp"]
