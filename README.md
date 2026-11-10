# Orderly

Orderly is a SaaS AI phone receptionist for Nigerian small businesses. Each business signs up and adds its menu, connects its own Paystack account and gets a phone number. The AI agent (OpenRouter) answers calls, takes orders and sends a payment link.

The model never holds order state. A deterministic state machine (`src/orderMachine.js`) in Postgres holds every order, and each change goes through a validated tool call.

## Architecture ($0 hosting)
- **Backend:** AWS Lambda with a Function URL (`template.yaml`), running the Express app through `src/lambda.js`.
- **Database:** Neon Postgres, free tier, in the AWS us-east-1 region.
- **Frontend:** the `public/` folder deployed as a static site on Vercel.
- **Per business:** a Vapi assistant whose LLM URL includes the business id, a Vapi or Twilio phone number, and the business's own Paystack key, stored AES-GCM encrypted.

## Local dev
```
npm install
npm run db:up && npm run db:init
npm start                 # http://localhost:3000/login.html
npm test
```

## Deploy
1. **Database:** create a Neon project in AWS us-east-1 and copy the *pooled* connection string. Then run `DATABASE_URL=<neon url> npm run db:init`.
2. **Backend:** install the AWS SAM CLI and run `aws configure`, then:
   ```
   sam build && sam deploy --guided
   ```
   Fill in the parameters from your `.env`, and use `*` for FrontendUrl the first time. Copy the `ApiUrl` output.
3. **Frontend:** set `window.API_BASE` in `public/config.js` to the ApiUrl, without the trailing slash. On Vercel, create a new project with `public` as the root directory, or run `npx vercel public --prod`.
4. **Lock CORS:** run `sam deploy` again with FrontendUrl set to your Vercel URL.
5. **Each business:** signs up, adds its menu, then on the Setup page connects Paystack, pastes the webhook URL into Paystack, and gets a phone number.
