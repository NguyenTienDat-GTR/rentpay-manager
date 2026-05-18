import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import cookieParser = require('cookie-parser');
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);
  const clientUrl = config.get<string>('CLIENT_URL') ?? 'http://localhost:5173';

  app.setGlobalPrefix('api');
  app.enableCors({
    origin: clientUrl,
    credentials: true,
  });
  app.use(cookieParser());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
    }),
  );

  const port = Number(config.get<string>('PORT') ?? 5000);
  await app.listen(port);
}

bootstrap();
