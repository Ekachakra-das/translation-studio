#!/bin/bash

# Настройки безопасности для всех доменов
# Замените эти значения перед запуском
CF_API_TOKEN="YOUR_CLOUDFLARE_API_TOKEN"
# CF_ACCOUNT_ID="YOUR_ACCOUNT_ID"

# 1. Получаем список всех доменов (зон) в аккаунте
ZONES=$(curl -s -X GET "https://api.cloudflare.com/client/v4/zones" \
     -H "Authorization: Bearer $CF_API_TOKEN" \
     -H "Content-Type: application/json" | jq -r '.result[].id')

for ZONE_ID in $ZONES; do
    echo "Processing Zone: $ZONE_ID"

    # Применяем Rate Limit (10 запросов в минуту на API)
    curl -s -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/ratelimit/rules" \
         -H "Authorization: Bearer $CF_API_TOKEN" \
         -H "Content-Type: application/json" \
         --data '{
           "name": "Global API Limit",
           "match": {
             "request": { "url": "*/api/*" }
           },
           "ratelimit": {
             "characteristics": ["ip.src"],
             "period": 60,
             "requests_per_period": 10,
             "mitigation": { "action": "block" }
           }
         }'

    # Включаем автоматическую защиту от ботов (Bot Fight Mode)
    curl -s -X PATCH "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/bot_management" \
         -H "Authorization: Bearer $CF_API_TOKEN" \
         -H "Content-Type: application/json" \
         --data '{"fight_mode": true}'

    echo "✅ Applied protection to $ZONE_ID"
done
