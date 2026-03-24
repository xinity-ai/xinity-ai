#!/bin/bash
set -e

# Xinity AI Docker Compose Setup Script
# This script helps set up the deployment for the first time

echo "🚀 Xinity AI Docker Compose Setup"
echo "=================================="
echo ""

# Check prerequisites
echo "📋 Checking prerequisites..."

if ! command -v docker &> /dev/null; then
    echo "❌ Docker is not installed. Please install Docker first."
    exit 1
fi

if ! command -v docker compose &> /dev/null; then
    echo "❌ Docker Compose is not installed. Please install Docker Compose first."
    exit 1
fi

echo "✅ Docker and Docker Compose are installed"
echo ""

# Check if .env exists
if [ -f .env ]; then
    echo "⚠️  .env file already exists."
    read -p "Do you want to overwrite it? (y/N): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Keeping existing .env file."
        echo ""
    else
        rm .env
    fi
fi

# Create .env from example if it doesn't exist
if [ ! -f .env ]; then
    echo "📝 Creating .env file from template..."
    cp .env.example .env
    echo "✅ .env file created"
    echo ""
fi

# Note about models.yaml
echo "ℹ️  Note: The dashboard uses the public Xinity model registry by default."
echo "   You only need models.yaml if hosting a custom model registry."
echo ""

# Generate secure passwords and secrets
echo "🔐 Generating secure credentials..."

if command -v openssl &> /dev/null; then
    POSTGRES_PASSWORD=$(openssl rand -base64 32)
    REDIS_PASSWORD=$(openssl rand -base64 32)
    BETTER_AUTH_SECRET=$(openssl rand -base64 32)

    # Update .env file with generated passwords
    sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=${POSTGRES_PASSWORD}|" .env
    sed -i "s|^REDIS_PASSWORD=.*|REDIS_PASSWORD=${REDIS_PASSWORD}|" .env
    sed -i "s|^BETTER_AUTH_SECRET=.*|BETTER_AUTH_SECRET=${BETTER_AUTH_SECRET}|" .env

    echo "✅ Secure credentials generated and saved to .env"
else
    echo "⚠️  openssl not found. Please manually set passwords in .env"
fi
echo ""

# Prompt for required settings
echo "⚙️  Configuration"
echo "----------------"
echo "Please configure the following required settings in .env:"
echo ""

read -p "Enter your domain (e.g., example.com): " DOMAIN
if [ ! -z "$DOMAIN" ]; then
    sed -i "s|^DOMAIN=.*|DOMAIN=${DOMAIN}|" .env
fi

read -p "Enter your email for SSL certificates: " ACME_EMAIL
if [ ! -z "$ACME_EMAIL" ]; then
    sed -i "s|^ACME_EMAIL=.*|ACME_EMAIL=${ACME_EMAIL}|" .env
fi

echo ""
echo "✅ Configuration updated"
echo ""

# Set proper permissions
echo "🔒 Setting secure file permissions..."
chmod 600 .env
echo "✅ .env file secured (chmod 600)"
echo ""

# Summary
echo "✅ Setup complete!"
echo ""
echo "📝 Next steps:"
echo "1. Review and edit .env file if needed"
echo "2. Configure your models in models.yaml"
echo "3. Ensure your domain DNS points to this server"
echo "4. Start services with: docker compose up -d"
echo "5. View logs with: docker compose logs -f"
echo ""
echo "📚 For more information, see README.md"
echo ""
echo "🔐 Important: Keep your .env file secure and never commit it to version control!"
