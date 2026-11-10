#!/usr/bin/env bash
# Deploys the backend to AWS Lambda + Function URL with the plain AWS CLI (no SAM needed).
# Usage: bash scripts/deploy.sh   (reads secrets from .env; uses PROD_DATABASE_URL for the database)
set -euo pipefail
cd "$(dirname "$0")/.."

FN=orderly-api
ROLE=orderly-lambda-role
REGION=${AWS_REGION:-us-east-1}
export AWS_REGION=$REGION AWS_PAGER=""

echo "→ Packaging"
rm -rf .build && mkdir -p .build/pkg
cp -r src package.json package-lock.json .build/pkg/
(cd .build/pkg && npm ci --omit=dev --silent)
if command -v zip >/dev/null; then (cd .build/pkg && zip -qr ../function.zip .)
else (cd .build/pkg && /c/Windows/System32/tar.exe -a -cf ../function.zip *); fi  # Windows bsdtar writes zip

echo "→ Environment"
node -e '
const fs = require("fs");
const env = Object.fromEntries(fs.readFileSync(".env", "utf8").split(/\r?\n/).filter(l => /^[A-Z_]+=/.test(l)).map(l => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));
if (!env.PROD_DATABASE_URL) { console.error("PROD_DATABASE_URL missing in .env"); process.exit(1); }
const keep = ["APP_SECRET","OPENROUTER_API_KEY","OPENROUTER_MODEL","VAPI_API_KEY","VAPI_PUBLIC_KEY","VAPI_SECRET","FRONTEND_URL","SMS_WEBHOOK_URL","SMS_API_KEY","CUSTOMER_EMAIL_DOMAIN"];
const vars = { NODE_ENV: "production", DATABASE_URL: env.PROD_DATABASE_URL };
for (const k of keep) if (env[k]) vars[k] = env[k];
fs.writeFileSync(".build/env.json", JSON.stringify({ Variables: vars }));
'

echo "→ IAM role"
if ! ROLE_ARN=$(aws iam get-role --role-name $ROLE --query Role.Arn --output text 2>/dev/null); then
  ROLE_ARN=$(aws iam create-role --role-name $ROLE --query Role.Arn --output text \
    --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}')
  aws iam attach-role-policy --role-name $ROLE --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
  echo "  waiting for role to propagate"; sleep 12
fi

echo "→ Lambda function"
if aws lambda get-function --function-name $FN >/dev/null 2>&1; then
  aws lambda update-function-code --function-name $FN --zip-file fileb://.build/function.zip >/dev/null
  aws lambda wait function-updated-v2 --function-name $FN
  aws lambda update-function-configuration --function-name $FN --environment file://.build/env.json >/dev/null
else
  aws lambda create-function --function-name $FN --runtime nodejs22.x --architectures arm64 \
    --handler src/lambda.handler --role "$ROLE_ARN" --memory-size 512 --timeout 60 \
    --zip-file fileb://.build/function.zip --environment file://.build/env.json >/dev/null
fi
aws lambda wait function-updated-v2 --function-name $FN

echo "→ Function URL"
if ! URL=$(aws lambda get-function-url-config --function-name $FN --query FunctionUrl --output text 2>/dev/null); then
  URL=$(aws lambda create-function-url-config --function-name $FN --auth-type NONE --query FunctionUrl --output text)
  aws lambda add-permission --function-name $FN --statement-id public-url --action lambda:InvokeFunctionUrl \
    --principal '*' --function-url-auth-type NONE >/dev/null
  aws lambda add-permission --function-name $FN --statement-id public-invoke --action lambda:InvokeFunction \
    --principal '*' --invoked-via-function-url >/dev/null 2>&1 || true
fi
URL=${URL%/}
echo "window.API_BASE = '$URL';" > public/config.js
rm -rf .build
echo "✔ Backend live: $URL  (public/config.js updated for Vercel)"
