#!/usr/bin/env bash
# One-time: S3 bucket for showcase media (public read under media/, browser uploads via presigned URLs).
set -euo pipefail
cd "$(dirname "$0")/.."
export AWS_REGION=us-east-1 AWS_PAGER=""
ACCT=$(aws sts get-caller-identity --query Account --output text)
B="orderly-media-$ACCT"
aws s3api head-bucket --bucket "$B" 2>/dev/null || aws s3api create-bucket --bucket "$B" >/dev/null
aws s3api put-public-access-block --bucket "$B" --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=false,RestrictPublicBuckets=false
aws s3api put-bucket-policy --bucket "$B" --policy "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Principal\":\"*\",\"Action\":\"s3:GetObject\",\"Resource\":\"arn:aws:s3:::$B/media/*\"}]}"
aws s3api put-bucket-cors --bucket "$B" --cors-configuration '{"CORSRules":[{"AllowedOrigins":["*"],"AllowedMethods":["PUT","GET"],"AllowedHeaders":["*"],"MaxAgeSeconds":3600}]}'
aws iam put-role-policy --role-name orderly-lambda-role --policy-name orderly-media --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":[\"s3:PutObject\",\"s3:DeleteObject\"],\"Resource\":\"arn:aws:s3:::$B/media/*\"}]}"
grep -q '^MEDIA_BUCKET=' .env && sed -i "s|^MEDIA_BUCKET=.*|MEDIA_BUCKET=$B|" .env || echo "MEDIA_BUCKET=$B" >> .env
echo "✔ Media bucket ready: $B"
