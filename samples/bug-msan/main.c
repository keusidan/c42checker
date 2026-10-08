/* ************************************************************************** */
/*                                                                            */
/*                                                        :::      ::::::::   */
/*   main.c                                             :+:      :+:    :+:   */
/*                                                    +:+ +:+         +:+     */
/*   By: ponzu <ponzu@student.42tokyo.jp>           +#+  +:+       +#+        */
/*                                                +#+#+#+#+#+   +#+           */
/*   Created: 2026/10/08 12:00:00 by ponzu             #+#    #+#             */
/*   Updated: 2026/10/08 12:00:00 by ponzu            ###   ########.fr       */
/*                                                                            */
/* ************************************************************************** */

#include <stdio.h>
#include <stdlib.h>

int	main(int argc, char **argv)
{
	char	*buf;

	(void)argv;
	buf = malloc(4);
	if (buf == NULL)
		return (1);
	if (buf[argc] == 'x')
		printf("x\n");
	free(buf);
	return (0);
}
