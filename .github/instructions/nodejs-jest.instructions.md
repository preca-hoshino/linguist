---
description: "Guidelines for writing Node.js and TypeScript code with Jest testing"
applyTo: '**/*.ts, **/*.js'
---

# Code Generation Guidelines

## Coding standards
- Use TypeScript with Node.js (CommonJS modules)
- Use Node.js built-in modules and avoid external dependencies where possible
- Ask the user if you require any additional dependencies before adding them
- Always use async/await for asynchronous code
- Keep the code simple and maintainable
- Use descriptive variable and function names
- Do not add comments unless absolutely necessary, the code should be self-explanatory
- Never use `null`, always use `undefined` for optional values
- Follow the existing project patterns (GatewayError, middleware chain, etc.)

## Testing
- Use **Jest** for testing (with ts-node)
- Write tests for all new features and bug fixes
- Ensure tests cover edge cases and error handling
- Never change the original code to make it easier to test
- Use `jest.mock('@/module', ...)` for mocking
- Use `jest.fn<ReturnType, Args>()` for type-safe mock functions
- Test files should be co-located with source files (`*.test.ts`)

## Documentation
- When adding new features or making significant changes, update the README.md file where necessary

## User interactions
- Ask questions if you are unsure about the implementation details, design choices, or need clarification on the requirements
- Always answer in the same language as the question, but use english for the generated content like code, comments or docs
