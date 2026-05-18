import { IsNotEmpty, Matches, MinLength } from 'class-validator';

export class LoginDto {
  @Matches(/^(0|\+84)[0-9]{9,10}$/)
  phone: string;

  @IsNotEmpty()
  @MinLength(6)
  password: string;
}
